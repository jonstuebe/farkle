import React from 'react';
import { Link } from 'react-router';

const Button = React.createClass({
    getDefaultProps() {
        return {
            style: {}
        }
    },
    render(){
        return (
            <Link className='button button--light' to={this.props.to} style={this.props.style}>
                {this.props.children}
            </Link>
        )
    }
});

export default Button
