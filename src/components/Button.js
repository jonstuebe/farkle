import React from 'react';
import { Link } from 'react-router';

const Button = React.createClass({
    getDefaultProps() {
        return {
            style: {},
            light: true,
            secondary: false
        }
    },
    render(){

        let buttonClass = ['button'];

        if(this.props.light) {
            buttonClass.push('button--light');
        }

        if(this.props.secondary) {
            buttonClass.push('button--secondary');
        }

        let attrs = {
            className: buttonClass.join(' '),
            style: this.props.style,
        };



        if(this.props.onClick) {
            return (
                <a onClick={this.props.onClick} {...attrs}>
                    {this.props.children}
                </a>
            );
        }

        return (
            <Link to={this.props.to} {...attrs}>
                {this.props.children}
            </Link>
        )
    }
});

export default Button
